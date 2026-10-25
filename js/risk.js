// Terrain flood susceptibility.
// Works on a plain elevation grid (row-major Float32Array, meters) so it can be
// tested without a browser. Four terrain signals are combined:
//   1. How much lower a spot is than the ground within about 500 ft
//   2. How much lower it is than the ground within about 1,600 ft
//   3. How much upstream area drains through it (flow accumulation)
//   4. Whether it sits in a closed dip that holds water (sink depth)

const DIRS = [
  [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2],
  [-1, 0, 1], [1, 0, 1],
  [-1, 1, Math.SQRT2], [0, 1, 1], [1, 1, Math.SQRT2],
];

export function boxMean(src, w, h, r) {
  const stride = w + 1;
  const sums = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    for (let x = 0; x < w; x += 1) {
      row += src[y * w + x];
      sums[(y + 1) * stride + (x + 1)] = sums[y * stride + (x + 1)] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w - 1, x + r);
      const total = sums[(y1 + 1) * stride + (x1 + 1)] - sums[y0 * stride + (x1 + 1)]
        - sums[(y1 + 1) * stride + x0] + sums[y0 * stride + x0];
      out[y * w + x] = total / ((y1 - y0 + 1) * (x1 - x0 + 1));
    }
  }
  return out;
}

class MinHeap {
  constructor(capacity) {
    this.vals = new Float64Array(capacity);
    this.ids = new Int32Array(capacity);
    this.size = 0;
  }

  push(val, id) {
    let k = this.size;
    this.size += 1;
    this.vals[k] = val;
    this.ids[k] = id;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (this.vals[parent] <= this.vals[k]) break;
      this.swap(parent, k);
      k = parent;
    }
  }

  pop() {
    const top = this.ids[0];
    this.size -= 1;
    if (this.size > 0) {
      this.vals[0] = this.vals[this.size];
      this.ids[0] = this.ids[this.size];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < this.size && this.vals[l] < this.vals[m]) m = l;
        if (r < this.size && this.vals[r] < this.vals[m]) m = r;
        if (m === k) break;
        this.swap(m, k);
        k = m;
      }
    }
    return top;
  }

  swap(a, b) {
    const v = this.vals[a]; this.vals[a] = this.vals[b]; this.vals[b] = v;
    const i = this.ids[a]; this.ids[a] = this.ids[b]; this.ids[b] = i;
  }
}

// Priority-flood sink filling (Barnes et al. 2014). With eps > 0 every filled
// cell still slopes gently toward an outlet, which lets flow routing cross flats.
export function priorityFlood(elev, w, h, eps = 0) {
  const n = w * h;
  const filled = Float32Array.from(elev);
  const closed = new Uint8Array(n);
  const heap = new MinHeap(n);
  for (let x = 0; x < w; x += 1) {
    for (const y of [0, h - 1]) {
      const id = y * w + x;
      if (!closed[id]) { closed[id] = 1; heap.push(filled[id], id); }
    }
  }
  for (let y = 1; y < h - 1; y += 1) {
    for (const x of [0, w - 1]) {
      const id = y * w + x;
      if (!closed[id]) { closed[id] = 1; heap.push(filled[id], id); }
    }
  }
  while (heap.size > 0) {
    const c = heap.pop();
    const cx = c % w;
    const cy = (c - cx) / w;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      if (closed[nb]) continue;
      closed[nb] = 1;
      if (filled[nb] < filled[c] + eps) filled[nb] = filled[c] + eps;
      heap.push(filled[nb], nb);
    }
  }
  return filled;
}

// D8 flow accumulation: each cell passes its water to its steepest downhill neighbor.
// Returns the number of cells (including itself) that drain through each cell.
export function flowAccumulation(dem, w, h) {
  const n = w * h;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;
  order.sort((a, b) => dem[b] - dem[a]);
  const acc = new Float32Array(n).fill(1);
  for (let k = 0; k < n; k += 1) {
    const c = order[k];
    const cx = c % w;
    const cy = (c - cx) / w;
    let best = -1;
    let bestSlope = 0;
    for (const [dx, dy, dist] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nb = ny * w + nx;
      const slope = (dem[c] - dem[nb]) / dist;
      if (slope > bestSlope) { bestSlope = slope; best = nb; }
    }
    if (best >= 0) acc[best] += acc[c];
  }
  return acc;
}

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

export function normalize(values, lo = 0.05, hi = 0.95) {
  const sorted = Float32Array.from(values).sort();
  const a = percentile(sorted, lo);
  const b = percentile(sorted, hi);
  const out = new Float32Array(values.length);
  if (!(b > a)) return out;
  for (let i = 0; i < values.length; i += 1) {
    out[i] = Math.min(1, Math.max(0, (values[i] - a) / (b - a)));
  }
  return out;
}

export function buildTerrainModel(elev, w, h, cellM) {
  const n = w * h;
  const rLocal = Math.max(2, Math.round(150 / cellM));
  const rBroad = Math.max(4, Math.round(500 / cellM));
  const meanLocal = boxMean(elev, w, h, rLocal);
  const meanBroad = boxMean(elev, w, h, rBroad);
  const filled = priorityFlood(elev, w, h, 0);
  const routed = priorityFlood(elev, w, h, 1e-4);
  const acc = flowAccumulation(routed, w, h);

  const tpiLocal = new Float32Array(n);
  const tpiBroad = new Float32Array(n);
  const pond = new Float32Array(n);
  const lowLocalRaw = new Float32Array(n);
  const lowBroadRaw = new Float32Array(n);
  const concRaw = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    tpiLocal[i] = elev[i] - meanLocal[i];
    tpiBroad[i] = elev[i] - meanBroad[i];
    pond[i] = Math.max(0, filled[i] - elev[i]);
    lowLocalRaw[i] = -tpiLocal[i];
    lowBroadRaw[i] = -tpiBroad[i];
    concRaw[i] = Math.log1p(acc[i]);
  }
  const lowLocal = normalize(lowLocalRaw);
  const lowBroad = normalize(lowBroadRaw);
  const conc = normalize(concRaw, 0.5, 0.995);

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const ponding = Math.min(1, pond[i] / 1.0);
    raw[i] = 0.3 * lowLocal[i] + 0.2 * lowBroad[i] + 0.3 * conc[i] + 0.2 * ponding;
  }
  const smooth = boxMean(raw, w, h, 1);
  const score = normalize(smooth, 0.02, 0.995);
  // smooth keeps the unclamped ordering, used to break ties among top-scoring cells
  return { w, h, cellM, elev, tpiLocal, tpiBroad, acc, pond, score, rank: smooth, rLocalM: rLocal * cellM, rBroadM: rBroad * cellM };
}

// Rain scales how much the terrain matters right now.
export function weatherFactor(rainInPerHr) {
  return 0.12 + 0.88 * Math.min(1, Math.max(0, rainInPerHr) / 1.0);
}

// observations: [{ i, j, strength }] in grid cells, strength 0..1
export function liveRisk(model, factor, observations, sigmaM = 90) {
  const { w, h, score, cellM } = model;
  const out = new Float32Array(w * h);
  for (let k = 0; k < out.length; k += 1) out[k] = score[k] * factor;
  const sigma = sigmaM / cellM;
  const reach = Math.ceil(sigma * 3);
  for (const ob of observations) {
    for (let y = Math.max(0, ob.j - reach); y <= Math.min(h - 1, ob.j + reach); y += 1) {
      for (let x = Math.max(0, ob.i - reach); x <= Math.min(w - 1, ob.i + reach); x += 1) {
        const d2 = (x - ob.i) ** 2 + (y - ob.j) ** 2;
        const bump = ob.strength * Math.exp(-d2 / (2 * sigma * sigma));
        const k = y * w + x;
        out[k] = 1 - (1 - out[k]) * (1 - bump);
      }
    }
  }
  return out;
}

const RAMP = [
  [0.0, 255, 214, 102, 0],
  [0.12, 255, 214, 102, 0.22],
  [0.35, 247, 166, 35, 0.42],
  [0.6, 228, 94, 38, 0.58],
  [0.85, 178, 28, 32, 0.7],
  [1.0, 140, 18, 30, 0.76],
];

export function rampColor(v) {
  const t = Math.min(1, Math.max(0, v));
  for (let s = 1; s < RAMP.length; s += 1) {
    if (t <= RAMP[s][0]) {
      const a = RAMP[s - 1];
      const b = RAMP[s];
      const f = (t - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f, a[4] + (b[4] - a[4]) * f];
    }
  }
  const last = RAMP[RAMP.length - 1];
  return [last[1], last[2], last[3], last[4]];
}

export function colorize(values) {
  const rgba = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v < 0.06) continue;
    const [r, g, b, a] = rampColor(v);
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = a * 255;
  }
  return rgba;
}

export const RISK_LEVELS = [
  { key: 'low', label: 'Low', max: 0.25, color: '#2f7d4f' },
  { key: 'moderate', label: 'Moderate', max: 0.5, color: '#a87a00' },
  { key: 'high', label: 'High', max: 0.75, color: '#d0610b' },
  { key: 'severe', label: 'Severe', max: Infinity, color: '#c0392b' },
];

export function riskLevel(v) {
  return RISK_LEVELS.find((l) => v < l.max) || RISK_LEVELS[RISK_LEVELS.length - 1];
}

// Value at a given fraction of the way up the sorted distribution.
export function quantile(values, p, mask = null) {
  const picked = [];
  for (let i = 0; i < values.length; i += 1) if (!mask || mask[i]) picked.push(values[i]);
  if (!picked.length) return 0;
  picked.sort((a, b) => a - b);
  return percentile(picked, p);
}

// Share of cells (optionally within mask) with a lower score than this one.
export function percentRank(values, idx, mask = null) {
  let below = 0;
  let total = 0;
  const v = values[idx];
  for (let i = 0; i < values.length; i += 1) {
    if (mask && !mask[i]) continue;
    total += 1;
    if (values[i] < v) below += 1;
  }
  return total ? below / total : 0;
}

// Pick the highest-scoring spots that are spread apart and away from existing sensors.
export function recommendSites(model, { mask = null, existing = [], count = 5, minSepM = 220, avoidM = 260, minScore = 0.55 } = {}) {
  const { w, h, score, cellM } = model;
  const order = model.rank || score;
  const sep2 = (minSepM / cellM) ** 2;
  const avoid2 = (avoidM / cellM) ** 2;
  const edge = Math.ceil(120 / cellM);
  const ids = [];
  for (let i = 0; i < score.length; i += 1) {
    if (score[i] < minScore) continue;
    if (mask && !mask[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    if (x < edge || y < edge || x >= w - edge || y >= h - edge) continue;
    ids.push(i);
  }
  ids.sort((a, b) => order[b] - order[a]);
  const picked = [];
  for (const id of ids) {
    const x = id % w;
    const y = (id - x) / w;
    if (existing.some((e) => (e.i - x) ** 2 + (e.j - y) ** 2 < avoid2)) continue;
    if (picked.some((p) => (p.i - x) ** 2 + (p.j - y) ** 2 < sep2)) continue;
    picked.push({ i: x, j: y, idx: id, score: score[id] });
    if (picked.length >= count) break;
  }
  return picked;
}

export const SQM_PER_ACRE = 4046.86;
export const FT_PER_M = 3.28084;
